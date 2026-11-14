import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { Recurrence } from '@shared/schedule'
import type { AgentPermissions, ApprovalPayload, Appearance, ConstellationLimits, PlanTaskRecord, RateLimitWindow, StructuredResult, SubtaskSpec } from '@shared/types'

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
const createdAt = () => text('created_at').notNull().default(now)
const updatedAt = () => text('updated_at').notNull().default(now)

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    role: text('role').notNull().default(''),
    description: text('description').notNull().default(''),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    instructions: text('instructions').notNull().default(''),
    autonomy: text('autonomy', { enum: ['manual', 'supervised', 'automated'] }).notNull().default('supervised'),
    permissions: text('permissions', { mode: 'json' }).$type<AgentPermissions>().notNull(),
    workingDirectory: text('working_directory'),
    isolation: text('isolation').notNull().default('standard'),
    effort: text('effort'),
    runtime: text('runtime').notNull().default('local'),
    machineId: text('machine_id'),
    dailyBudgetUsd: real('daily_budget_usd'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    status: text('status').notNull().default('available'),
    statusText: text('status_text'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('agents_sort_idx').on(t.sortOrder)],
)

/** One row per agent: creature + planet. */
export const agentAppearances = sqliteTable('agent_appearances', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  appearance: text('appearance', { mode: 'json' }).$type<Appearance>().notNull(),
  updatedAt: updatedAt(),
})

export const providerConnections = sqliteTable('provider_connections', {
  providerId: text('provider_id').primaryKey(),
  /** base64 of safeStorage-encrypted secret; never plaintext */
  encryptedSecret: text('encrypted_secret'),
  secretHint: text('secret_hint'),
  lastValidatedAt: text('last_validated_at'),
  lastError: text('last_error'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const modelConfigurations = sqliteTable(
  'model_configurations',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    inputPricePerMTok: real('input_price_per_mtok'),
    outputPricePerMTok: real('output_price_per_mtok'),
    pricingDate: text('pricing_date'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('model_cfg_unique').on(t.providerId, t.model)],
)

export const machines = sqliteTable('machines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),
  platform: text('platform').notNull(),
  status: text('status').notNull(),
  lastHeartbeatAt: text('last_heartbeat_at'),
  details: text('details', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  createdAt: createdAt(),
})

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    providerSessionId: text('provider_session_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_agent_idx').on(t.agentId, t.updatedAt)],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    status: text('status', { enum: ['streaming', 'complete', 'error', 'cancelled'] }).notNull(),
    error: text('error'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    costKind: text('cost_kind'),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
)

export const missions = sqliteTable(
  'missions',
  {
    id: text('id').primaryKey(),
    shortId: text('short_id').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    priority: text('priority').notNull().default('normal'),
    status: text('status').notNull().default('todo'),
    result: text('result'),
    error: text('error'),
    costUsd: real('cost_usd'),
    costKind: text('cost_kind'),
    workflowId: text('workflow_id'),
    parentMissionId: text('parent_mission_id'),
    constellationRunId: text('constellation_run_id'),
    depth: integer('depth').notNull().default(0),
    /** Delegated sub-mission contract (objective, expected result, context…). */
    subtask: text('subtask', { mode: 'json' }).$type<SubtaskSpec>(),
    /** Permissions for this mission when lower than the companion's (delegation ceiling). */
    permissionsOverride: text('permissions_override', { mode: 'json' }).$type<AgentPermissions>(),
    /** Set when the mission is owned by a remote runtime (this row is a synced copy). */
    remoteMachineId: text('remote_machine_id'),
    resultData: text('result_data', { mode: 'json' }).$type<StructuredResult>(),
    engine: text('engine'),
    sessionId: text('session_id'),
    workspace: text('workspace'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('missions_status_idx').on(t.status),
    index('missions_agent_idx').on(t.agentId),
    uniqueIndex('missions_short_id_unique').on(t.shortId),
  ],
)

export const missionExecutions = sqliteTable(
  'mission_executions',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    /** Prevents double-starting the same attempt (scheduler restarts, double clicks). */
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull(),
    prompt: text('prompt'),
    error: text('error'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    costKind: text('cost_kind'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [uniqueIndex('executions_idem_unique').on(t.idempotencyKey)],
)

export const executionEvents = sqliteTable(
  'execution_events',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    executionId: text('execution_id').notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('exec_events_mission_idx').on(t.missionId, t.createdAt)],
)

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: text('id').primaryKey(),
    executionId: text('execution_id'),
    conversationId: text('conversation_id'),
    missionId: text('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    externalId: text('external_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('other'),
    title: text('title').notNull().default(''),
    input: text('input', { mode: 'json' }).$type<unknown>(),
    output: text('output'),
    files: text('files', { mode: 'json' }).$type<string[]>(),
    exitCode: integer('exit_code'),
    status: text('status').notNull(),
    createdAt: createdAt(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('tool_calls_mission_idx').on(t.missionId, t.createdAt), index('tool_calls_external_idx').on(t.executionId, t.externalId)],
)

export const fileChanges = sqliteTable(
  'file_changes',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    executionId: text('execution_id').notNull(),
    path: text('path').notNull(),
    kind: text('kind').notNull(),
    diff: text('diff'),
    agentId: text('agent_id'),
    /** engine: reported by the engine · git/scan: found by Orbit's before/after snapshot. */
    source: text('source').notNull().default('engine'),
    createdAt: createdAt(),
  },
  (t) => [index('file_changes_mission_idx').on(t.missionId, t.createdAt)],
)

/** One row per execution: how the file list was obtained and whether it is complete. */
export const fileInventories = sqliteTable(
  'file_inventories',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    executionId: text('execution_id').notNull(),
    agentId: text('agent_id').notNull(),
    method: text('method').notNull(),
    complete: integer('complete', { mode: 'boolean' }).notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [index('file_inventories_mission_idx').on(t.missionId)],
)

/** Every decision taken by a security layer (policy, engine sandbox, isolation). */
export const securityAuditEvents = sqliteTable(
  'security_audit_events',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id'),
    missionId: text('mission_id'),
    layer: text('layer').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    decision: text('decision').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('security_audit_created_idx').on(t.createdAt)],
)

/**
 * Persistent « yes » given by the user (« for this mission » / « always for this companion and
 * this folder »), limited to one exact operation. Only written from the UI, never by an engine.
 */
export const permissionGrants = sqliteTable(
  'permission_grants',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    workspace: text('workspace').notNull(),
    scope: text('scope').notNull(),
    missionId: text('mission_id'),
    kind: text('kind').notNull(),
    operationKey: text('operation_key').notNull(),
    label: text('label').notNull(),
    category: text('category'),
    uses: integer('uses').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('permission_grants_lookup_idx').on(t.agentId, t.operationKey)],
)

/** Official subscription rate-limit snapshots emitted by an engine during a run. */
export const subscriptionUsageRecords = sqliteTable(
  'subscription_usage_records',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    windows: text('windows', { mode: 'json' }).$type<RateLimitWindow[]>().notNull(),
    source: text('source').notNull(),
    observedAt: text('observed_at').notNull(),
  },
  (t) => [index('subscription_usage_provider_idx').on(t.providerId, t.observedAt)],
)

export const approvalRequests = sqliteTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    missionId: text('mission_id'),
    executionId: text('execution_id'),
    toolCallId: text('tool_call_id'),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    detail: text('detail'),
    payload: text('payload', { mode: 'json' }).$type<ApprovalPayload>(),
    status: text('status').notNull().default('pending'),
    createdAt: createdAt(),
    resolvedAt: text('resolved_at'),
    /** Owning runtime (synced copy), operation fingerprint the answer is bound to, deadline. */
    machineId: text('machine_id'),
    operationHash: text('operation_hash'),
    expiresAt: text('expires_at'),
    resolvedBy: text('resolved_by'),
  },
  (t) => [index('approvals_status_idx').on(t.status)],
)

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  coordinatorAgentId: text('coordinator_agent_id').notNull(),
  missionId: text('mission_id'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
})

export const workflowSteps = sqliteTable('workflow_steps', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id')
    .notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  agentId: text('agent_id').notNull(),
  missionId: text('mission_id'),
  dependsOn: text('depends_on', { mode: 'json' }).$type<string[]>().notNull(),
  status: text('status').notNull().default('todo'),
  createdAt: createdAt(),
})

export const agentMemories = sqliteTable(
  'agent_memories',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    includeInContext: integer('include_in_context', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('memories_agent_idx').on(t.agentId)],
)

export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id'),
    providerId: text('provider_id').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd'),
    costKind: text('cost_kind').notNull(),
    pricingVersion: text('pricing_version'),
    equivalentUsd: real('equivalent_usd'),
    source: text('source').notNull(),
    createdAt: createdAt(),
    /** Consumption recorded on a remote runtime. */
    machineId: text('machine_id'),
  },
  (t) => [index('usage_created_idx').on(t.createdAt), index('usage_agent_idx').on(t.agentId)],
)

export const providerHealthRecords = sqliteTable(
  'provider_health_records',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    level: text('level').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    checkedAt: text('checked_at').notNull(),
  },
  (t) => [index('health_provider_idx').on(t.providerId, t.checkedAt)],
)

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  title: text('title').notNull(),
  prompt: text('prompt').notNull(),
  recurrence: text('recurrence').notNull(),
  nextRunAt: text('next_run_at'),
  lastRunKey: text('last_run_key'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: createdAt(),
})

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    route: text('route'),
    read: integer('read', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    /** One notification per fact (remote replays, reconnections). */
    dedupeKey: text('dedupe_key'),
  },
  (t) => [index('notifications_created_idx').on(t.createdAt), uniqueIndex('notifications_dedupe_unique').on(t.dedupeKey)],
)

export const activityEvents = sqliteTable(
  'activity_events',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    level: text('level').notNull(),
    agentId: text('agent_id'),
    missionId: text('mission_id'),
    conversationId: text('conversation_id'),
    title: text('title').notNull(),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('activity_created_idx').on(t.createdAt), index('activity_agent_idx').on(t.agentId)],
)

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actor: text('actor').notNull(),
    agentId: text('agent_id'),
    action: text('action').notNull(),
    target: text('target'),
    allowed: integer('allowed', { mode: 'boolean' }).notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_created_idx').on(t.createdAt)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: updatedAt(),
})

// Constellations

export const constellationDefinitions = sqliteTable('constellation_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  objective: text('objective').notNull().default(''),
  coordinatorAgentId: text('coordinator_agent_id').notNull(),
  workspace: text('workspace'),
  workspaceMode: text('workspace_mode').notNull().default('shared'),
  permissions: text('permissions', { mode: 'json' }).$type<AgentPermissions>().notNull(),
  limits: text('limits', { mode: 'json' }).$type<ConstellationLimits>().notNull(),
  isTemplate: integer('is_template', { mode: 'boolean' }).notNull().default(false),
  /** When a coordinator's plan needs the user's explicit approval: never, when it writes, always. */
  planApproval: text('plan_approval').notNull().default('auto'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const constellationMembers = sqliteTable(
  'constellation_members',
  {
    constellationId: text('constellation_id')
      .notNull()
      .references(() => constellationDefinitions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default(''),
    responsibilities: text('responsibilities').notNull().default(''),
    canDelegate: integer('can_delegate', { mode: 'boolean' }).notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('constellation_members_pk').on(t.constellationId, t.agentId)],
)

export const constellationRuns = sqliteTable(
  'constellation_runs',
  {
    id: text('id').primaryKey(),
    constellationId: text('constellation_id')
      .notNull()
      .references(() => constellationDefinitions.id, { onDelete: 'cascade' }),
    goal: text('goal').notNull(),
    status: text('status').notNull(),
    coordinatorAgentId: text('coordinator_agent_id').notNull(),
    coordinatorMissionId: text('coordinator_mission_id'),
    round: integer('round').notNull().default(0),
    workspace: text('workspace'),
    limits: text('limits', { mode: 'json' }).$type<ConstellationLimits>().notNull(),
    synthesis: text('synthesis'),
    error: text('error'),
    origin: text('origin').notNull().default('user'),
    /** Stable idempotency key (automation occurrence, double click…). */
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    /** Runtime that coordinates this run (synced copy on the Mac). */
    machineId: text('machine_id'),
    /** What the drive loop is doing inside an active status (planning, executing, synthesizing). */
    phase: text('phase'),
    /** Time actually spent driving (pauses and approvals excluded): the duration limit uses it. */
    activeMs: integer('active_ms').notNull().default(0),
    /** Last coordinator execution whose reply Orbit has read (a reply is never processed twice). */
    lastIngestedExecutionId: text('last_ingested_execution_id'),
    /** Optimistic concurrency: bumped on every lifecycle transition. */
    version: integer('version').notNull().default(0),
  },
  (t) => [index('constellation_runs_def_idx').on(t.constellationId, t.createdAt), uniqueIndex('constellation_runs_idem_unique').on(t.idempotencyKey)],
)

export const missionDependencies = sqliteTable(
  'mission_dependencies',
  {
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    dependsOnMissionId: text('depends_on_mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('mission_dependencies_pk').on(t.missionId, t.dependsOnMissionId)],
)

export const executionHandoffs = sqliteTable(
  'execution_handoffs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => constellationRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fromAgentId: text('from_agent_id').notNull(),
    toAgentId: text('to_agent_id').notNull(),
    missionId: text('mission_id'),
    summary: text('summary').notNull(),
    payload: text('payload').notNull(),
    redactions: integer('redactions').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('handoffs_run_idx').on(t.runId, t.createdAt)],
)

export const constellationPlans = sqliteTable(
  'constellation_plans',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => constellationRuns.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    round: integer('round').notNull(),
    /** proposed → approved | rejected | superseded ; invalid when Orbit refused it. */
    status: text('status').notNull(),
    hash: text('hash').notNull(),
    tasks: text('tasks', { mode: 'json' }).$type<PlanTaskRecord[]>().notNull(),
    questions: text('questions', { mode: 'json' }).$type<string[]>().notNull(),
    note: text('note'),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull(),
    /** coordinator (drive loop), conversation (a chat reply outside the loop), user (edited). */
    source: text('source').notNull(),
    sourceExecutionId: text('source_execution_id'),
    approvalReason: text('approval_reason'),
    createdAt: createdAt(),
    decidedAt: text('decided_at'),
    decidedBy: text('decided_by'),
  },
  (t) => [uniqueIndex('constellation_plans_version_unique').on(t.runId, t.version), uniqueIndex('constellation_plans_source_unique').on(t.runId, t.sourceExecutionId)],
)

export const constellationRunEvents = sqliteTable(
  'constellation_run_events',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => constellationRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    actor: text('actor').notNull().default('orbit'),
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
  },
  (t) => [index('constellation_run_events_run_idx').on(t.runId, t.createdAt), uniqueIndex('constellation_run_events_idem_unique').on(t.idempotencyKey)],
)

export const agentWorkspaces = sqliteTable(
  'agent_workspaces',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => constellationRuns.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    path: text('path').notNull(),
    kind: text('kind').notNull(),
    branch: text('branch'),
    baseRef: text('base_ref'),
    status: text('status').notNull().default('active'),
    diffStat: text('diff_stat'),
    conflictWith: text('conflict_with', { mode: 'json' }).$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [index('agent_workspaces_run_idx').on(t.runId)],
)



// Automations

export const automationDefinitions = sqliteTable(
  'automation_definitions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    targetKind: text('target_kind').notNull(), // agent | constellation
    targetId: text('target_id').notNull(),
    title: text('title').notNull(),
    prompt: text('prompt').notNull(),
    /** Recurrence (shared/schedule.ts); null for purely event-triggered automations. */
    recurrence: text('recurrence', { mode: 'json' }).$type<Recurrence>(),
    timezone: text('timezone').notNull(),
    status: text('status').notNull().default('active'), // active | paused | completed
    missedPolicy: text('missed_policy').notNull().default('ask'), // skip | run_once | ask
    maxRunsPerDay: integer('max_runs_per_day'),
    nextRunAt: text('next_run_at'),
    lastRunAt: text('last_run_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** The one scheduler allowed to fire it: 'local' or a runtime machine id. */
    schedulerOwner: text('scheduler_owner').notNull().default('local'),
    /** active | transferring (no scheduler fires it until the transfer is confirmed). */
    ownerState: text('owner_state').notNull().default('active'),
    /** Machine a transfer is heading to (owner_state = transferring). */
    pendingOwner: text('pending_owner'),
    configVersion: integer('config_version').notNull().default(1),
    maxDurationMin: integer('max_duration_min'),
    budgetUsd: real('budget_usd'),
    /** notify | pause (pause the automation after a failed run). */
    failurePolicy: text('failure_policy').notNull().default('notify'),
  },
  (t) => [index('automations_next_idx').on(t.status, t.nextRunAt)],
)

export const automationTriggers = sqliteTable(
  'automation_triggers',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: 'cascade' }),
    /** mission.completed | mission.failed | mission.status | automation.completed */
    kind: text('kind').notNull(),
    sourceAgentId: text('source_agent_id'),
    sourceAutomationId: text('source_automation_id'),
    statusFilter: text('status_filter'),
    cooldownSec: integer('cooldown_sec').notNull().default(300),
    createdAt: createdAt(),
  },
  (t) => [index('automation_triggers_auto_idx').on(t.automationId)],
)

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automationDefinitions.id, { onDelete: 'cascade' }),
    scheduledFor: text('scheduled_for').notNull(),
    trigger: text('trigger').notNull(), // schedule | missed | manual | event
    status: text('status').notNull(), // pending_confirmation | running | done | failed | skipped | cancelled | uncertain
    missionId: text('mission_id'),
    constellationRunId: text('constellation_run_id'),
    note: text('note'),
    /** One run per occurrence: automation id + scheduled instant (or event id). */
    idempotencyKey: text('idempotency_key').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: createdAt(),
    machineId: text('machine_id'),
  },
  (t) => [uniqueIndex('automation_runs_idem_unique').on(t.idempotencyKey), index('automation_runs_auto_idx').on(t.automationId, t.createdAt)],
)

// Remote runtime

export const runtimeMachines = sqliteTable('runtime_machines', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** ssh: a real server through SSH · local: a runtime on this Mac (tests, VM shared folder). */
  transport: text('transport').notNull(),
  host: text('host'),
  user: text('user'),
  port: integer('port').notNull().default(22),
  runtimeHome: text('runtime_home').notNull(),
  /** Host key line pinned by the user (ssh-keyscan output), never trusted implicitly. */
  hostKey: text('host_key'),
  hostKeyFingerprint: text('host_key_fingerprint'),
  status: text('status').notNull().default('new'), // new | pending_host_key | ready | online | offline | error | revoked
  lastError: text('last_error'),
  lastHeartbeatAt: text('last_heartbeat_at'),
  runtimeVersion: text('runtime_version'),
  protocol: integer('protocol'),
  info: text('info', { mode: 'json' }).$type<Record<string, string>>(),
  engines: text('engines', { mode: 'json' }).$type<{ id: string; available: boolean; detail: string }[]>(),
  cursor: integer('cursor').notNull().default(0),
  createdAt: createdAt(),
  /** Runtime identity (Ed25519) pinned by the user, and this client's pairing. */
  runtimeId: text('runtime_id'),
  runtimeKey: text('runtime_key'),
  runtimeKeyFingerprint: text('runtime_key_fingerprint'),
  clientId: text('client_id'),
  pairedAt: text('paired_at'),
  schemaVersion: text('schema_version'),
  health: text('health', { mode: 'json' }).$type<Record<string, unknown>>(),
  metrics: text('metrics', { mode: 'json' }).$type<Record<string, unknown>>(),
  lastSyncedAt: text('last_synced_at'),
  syncError: text('sync_error'),
  limits: text('limits', { mode: 'json' }).$type<Record<string, unknown>>(),
  /** Private key reserved for Orbit (optional): only this key is offered to the server. */
  sshIdentityFile: text('ssh_identity_file'),
})

/**
 * Commands sent to a runtime. A command whose answer was lost (connection cut) is
 * resent after reconnection with the same request id: the runtime returns the stored
 * result instead of running it twice.
 */
export const remoteCommands = sqliteTable(
  'remote_commands',
  {
    requestId: text('request_id').primaryKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => runtimeMachines.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** pending (sent or not, answer unknown) | done | failed (definitive refusal) */
    status: text('status').notNull().default('pending'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    entityKind: text('entity_kind'),
    entityId: text('entity_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('remote_commands_machine_idx').on(t.machineId, t.status)],
)

/** Artifacts produced on a runtime (metadata synced; content fetched on demand, hash-checked). */
export const remoteArtifacts = sqliteTable(
  'remote_artifacts',
  {
    id: text('id').primaryKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => runtimeMachines.id, { onDelete: 'cascade' }),
    missionId: text('mission_id'),
    agentId: text('agent_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull(),
    localPath: text('local_path'),
    createdAt: createdAt(),
  },
  (t) => [index('remote_artifacts_mission_idx').on(t.missionId)],
)

export const remoteMissions = sqliteTable(
  'remote_missions',
  {
    /** = the runtime mission id = Orbit execution id (idempotency key). */
    id: text('id').primaryKey(),
    machineId: text('machine_id')
      .notNull()
      .references(() => runtimeMachines.id, { onDelete: 'cascade' }),
    missionId: text('mission_id'),
    status: text('status').notNull(),
    result: text('result'),
    error: text('error'),
    updatedAt: updatedAt(),
  },
  (t) => [index('remote_missions_machine_idx').on(t.machineId)],
)

export const runtimeEvents = sqliteTable(
  'runtime_events',
  {
    machineId: text('machine_id')
      .notNull()
      .references(() => runtimeMachines.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    missionId: text('mission_id'),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    at: text('at').notNull(),
  },
  (t) => [uniqueIndex('runtime_events_pk').on(t.machineId, t.seq)],
)
