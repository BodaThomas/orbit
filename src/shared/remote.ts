/**
 * Shapes of the Orbit runtime protocol shared with the UI (no Node types here).
 * The wire contract itself (methods, schemas, versions) lives in src/runtime/protocol.ts.
 */
export type RemoteEngineId = 'codex' | 'claude-code' | 'claude-agent' | 'anthropic' | 'openai'

export interface MachineLimits {
  /** Missions running at once on this runtime (queued beyond). */
  maxConcurrentMissions: number
  /** Hard stop for any single mission, in minutes. */
  maxMissionDurationMin: number
  /** API spend (measured or estimated) on this runtime; subscriptions have no price and are not counted. */
  dailyBudgetUsd: number | null
  monthlyBudgetUsd: number | null
}

export interface EngineStatus {
  id: RemoteEngineId
  name: string
  installed: boolean
  version: string | null
  authenticated: boolean | 'unknown'
  ready: boolean
  detail: string
  /** What the engine can do on this machine (approvals, resume, interrupt…). */
  capabilities: string[]
  restrictions: string[]
}

export interface HealthReport {
  live: true
  ready: boolean
  version: string
  protocol: number
  schemaVersion: string
  uptimeSec: number
  checks: { name: string; ok: boolean; detail: string }[]
  scheduler: { running: boolean; lastTickAt: string | null; activeAutomations: number; nextRunAt: string | null; recentFailures: number }
  missions: { running: number; queued: number; awaitingApproval: number; failed24h: number; done24h: number }
  lastErrors: { at: string; message: string }[]
}

export interface MetricsReport {
  at: string
  loadAvg: [number, number, number] | null
  cpus: number
  memory: { totalMb: number; freeMb: number; processRssMb: number }
  disk: { path: string; totalMb: number; freeMb: number } | null
  processes: number | null
  engineProcesses: number
  uptimeSec: number
  osUptimeSec: number
}

export interface ArtifactMeta {
  id: string
  missionId: string | null
  agentId: string | null
  name: string
  kind: 'report' | 'file' | 'diff' | 'log'
  size: number
  sha256: string
  status: 'stored' | 'skipped_quota' | 'skipped_size' | 'missing'
  createdAt: string
}
