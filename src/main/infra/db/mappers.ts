import type {
  ActivityEvent,
  Agent,
  AgentMemory,
  AgentStatus,
  ApprovalRequest,
  Appearance,
  AuditEntry,
  Conversation,
  CostKind,
  ExecutionEvent,
  FileChange,
  FileInventory,
  Message,
  Mission,
  MissionExecution,
  OrbitNotification,
  ProviderId,
  ToolCall,
} from '@shared/types'
import type * as s from './schema'

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect']

export function toAgent(row: Row<typeof s.agents>, appearance: Appearance): Agent {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    description: row.description,
    appearance,
    providerId: row.providerId as ProviderId,
    model: row.model,
    instructions: row.instructions,
    autonomy: row.autonomy,
    permissions: row.permissions,
    workingDirectory: row.workingDirectory,
    isolation: row.isolation === 'strict' ? 'strict' : 'standard',
    effort: row.effort,
    runtime: row.runtime === 'remote' ? 'remote' : 'local',
    machineId: row.machineId,
    dailyBudgetUsd: row.dailyBudgetUsd,
    enabled: row.enabled,
    status: (row.enabled ? row.status : 'disabled') as AgentStatus,
    statusText: row.statusText,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toConversation(row: Row<typeof s.conversations>, messageCount: number): Conversation {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    providerSessionId: row.providerSessionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount,
  }
}

export function toMessage(row: Row<typeof s.messages>): Message {
  return { ...row, costKind: row.costKind as CostKind | null }
}

export function toMission(row: Row<typeof s.missions>): Mission {
  return {
    ...row,
    priority: row.priority as Mission['priority'],
    status: row.status as Mission['status'],
    costKind: row.costKind as CostKind | null,
    engine: (row.engine as ProviderId | null) ?? null,
  }
}

export function toExecution(row: Row<typeof s.missionExecutions>): MissionExecution {
  return {
    id: row.id,
    missionId: row.missionId,
    prompt: row.prompt,
    status: row.status as MissionExecution['status'],
    error: row.error,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    costKind: row.costKind as CostKind | null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

export function toToolCall(row: Row<typeof s.toolCalls>): ToolCall {
  return {
    id: row.id,
    missionId: row.missionId ?? '',
    executionId: row.executionId ?? '',
    agentId: row.agentId,
    externalId: row.externalId ?? row.id,
    name: row.name,
    kind: row.kind as ToolCall['kind'],
    title: row.title,
    input: row.input ?? null,
    output: row.output,
    files: row.files ?? [],
    exitCode: row.exitCode,
    status: row.status as ToolCall['status'],
    startedAt: row.createdAt,
    finishedAt: row.finishedAt,
  }
}

export function toFileChange(row: Row<typeof s.fileChanges>): FileChange {
  return { ...row, kind: row.kind as FileChange['kind'], source: (row.source as FileChange['source']) ?? 'engine' }
}

export function toInventory(row: Row<typeof s.fileInventories>): FileInventory {
  return { ...row, method: row.method as FileInventory['method'] }
}

export function toExecutionEvent(row: Row<typeof s.executionEvents>): ExecutionEvent {
  return { ...row, type: row.type as ExecutionEvent['type'], data: row.data ?? null }
}

export function toApproval(row: Row<typeof s.approvalRequests>): ApprovalRequest {
  return {
    ...row,
    kind: row.kind as ApprovalRequest['kind'],
    status: row.status as ApprovalRequest['status'],
    payload: row.payload ?? null,
  }
}

export function toActivity(row: Row<typeof s.activityEvents>): ActivityEvent {
  return { ...row, type: row.type as ActivityEvent['type'], level: row.level as ActivityEvent['level'] }
}

export function toNotification(row: Row<typeof s.notifications>): OrbitNotification {
  return { ...row, kind: row.kind as OrbitNotification['kind'] }
}

export function toMemory(row: Row<typeof s.agentMemories>): AgentMemory {
  return { ...row, kind: row.kind as AgentMemory['kind'] }
}

export function toAudit(row: Row<typeof s.auditLogs>): AuditEntry {
  return { ...row, actor: row.actor as AuditEntry['actor'] }
}
