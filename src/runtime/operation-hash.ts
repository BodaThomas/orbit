import { createHash } from 'node:crypto'

/** Fingerprint an approval answer is bound to: same id, same operation, same content. */
export function operationHash(row: { id: string; kind: string; mission_id?: unknown; missionId?: unknown; tool_call_id?: unknown; toolCallId?: unknown; summary: string; payload: unknown }): string {
  const payload = typeof row.payload === 'string' ? row.payload : row.payload == null ? null : JSON.stringify(row.payload)
  return createHash('sha256')
    .update(JSON.stringify([row.id, row.kind, row.mission_id ?? row.missionId ?? null, row.tool_call_id ?? row.toolCallId ?? null, row.summary, payload]))
    .digest('hex')
    .slice(0, 32)
}
