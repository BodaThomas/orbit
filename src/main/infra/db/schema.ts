import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { AgentPermissions, ApprovalPayload, Appearance } from '@shared/types'

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
    createdAt: createdAt(),
  },
  (t) => [index('file_changes_mission_idx').on(t.missionId, t.createdAt)],
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
    source: text('source').notNull(),
    createdAt: createdAt(),
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
  },
  (t) => [index('notifications_created_idx').on(t.createdAt)],
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
