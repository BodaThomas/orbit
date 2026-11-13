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
  Message,
  Mission,
  OrbitNotification,
  ProviderId,
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
    runtime: 'local',
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
  }
}

export function toExecutionEvent(row: Row<typeof s.executionEvents>): ExecutionEvent {
  return { ...row, type: row.type as ExecutionEvent['type'], data: row.data ?? null }
}

export function toApproval(row: Row<typeof s.approvalRequests>): ApprovalRequest {
  return {
    ...row,
    kind: row.kind as ApprovalRequest['kind'],
    status: row.status as ApprovalRequest['status'],
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
