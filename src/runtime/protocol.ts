/**
 * Orbit runtime protocol (JSON-RPC 2.0, one JSON object per line).
 *
 * Transport: Orbit → `ssh -o StrictHostKeyChecking=yes … orbit-runtime attach` → Unix socket
 * (mode 0600) → daemon. Nothing listens on the network: SSH authenticates the user (keys),
 * encrypts the channel and verifies the host against the fingerprint the user pinned in Orbit.
 * The local token in the runtime home additionally proves that `attach` runs as the owner.
 */

export const PROTOCOL_VERSION = 1
export const RUNTIME_VERSION = '0.3.0'

export type RemoteEngineId = 'codex' | 'claude-code' | 'echo'

export interface RemotePolicy {
  readFiles: boolean
  writeFiles: boolean
  runCommands: boolean
  network: boolean
  autonomy: 'manual' | 'supervised' | 'automated'
}

export interface MissionSubmit {
  /** Idempotency key chosen by Orbit (its execution id): resubmitting never runs twice. */
  id: string
  engine: RemoteEngineId
  model: string | null
  /** Project folder name under <runtime home>/projects (no path, no traversal). */
  project: string
  prompt: string
  instructions: string
  sessionId: string | null
  policy: RemotePolicy
}

export type RemoteMissionStatus = 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled' | 'interrupted'

export interface RemoteMission {
  id: string
  engine: RemoteEngineId
  project: string
  status: RemoteMissionStatus
  sessionId: string | null
  result: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  /** Set when the mission was started by a runtime-side schedule. */
  scheduleId: string | null
}

export interface RemoteSchedule {
  id: string
  name: string
  /** shared/schedule.ts Recurrence. */
  recurrence: unknown
  timezone: string
  template: Omit<MissionSubmit, 'id'>
  nextRunAt: string | null
  lastRunAt: string | null
  enabled: boolean
}

/** Every observable fact, persisted on the runtime and replayable from a cursor. */
export interface RuntimeEvent {
  seq: number
  at: string
  missionId: string | null
  /** Normalised engine events (same shapes as Orbit's EngineEvent) plus lifecycle events. */
  kind: 'mission.status' | 'engine' | 'approval.requested' | 'approval.resolved' | 'schedule.fired' | 'runtime.started'
  data: Record<string, unknown>
}

export interface HelloResult {
  protocol: number
  runtimeVersion: string
  machine: { hostname: string; platform: string; arch: string; node: string; cpus: number; memoryGb: number }
  engines: { id: RemoteEngineId; available: boolean; detail: string }[]
  lastSeq: number
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
