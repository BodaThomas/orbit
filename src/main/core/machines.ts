import os from 'node:os'
import type { Machine, Workflow } from '@shared/types'
import { asc, eq } from 'drizzle-orm'
import type { OrbitDb } from '../infra/db/client'
import { machines, workflowSteps, workflows } from '../infra/db/schema'
import { nowIso } from './util'

export const LOCAL_MACHINE_ID = 'local'

/** MVP: the local Mac only. Remote runtimes are declared but not implemented. */
export class MachineRegistry {
  constructor(private db: OrbitDb) {}

  heartbeat(): void {
    const details = {
      Hôte: os.hostname(),
      Système: `${os.type()} ${os.release()}`,
      Architecture: os.arch(),
      Processeurs: `${os.cpus().length} cœurs`,
      Mémoire: `${Math.round(os.totalmem() / 1024 ** 3)} Go`,
      Node: process.versions.node,
      Electron: process.versions.electron ?? '—',
    }
    const values = { name: 'Ce Mac', kind: 'local', platform: `${process.platform}-${process.arch}`, status: 'online', lastHeartbeatAt: nowIso(), details }
    this.db.insert(machines).values({ id: LOCAL_MACHINE_ID, ...values }).onConflictDoUpdate({ target: machines.id, set: values }).run()
  }

  list(): Machine[] {
    return this.db.select().from(machines).all().map((m) => ({ ...m, kind: m.kind as Machine['kind'], status: m.status as Machine['status'] }))
  }
}

export function listWorkflows(db: OrbitDb): Workflow[] {
  return db
    .select()
    .from(workflows)
    .orderBy(asc(workflows.createdAt))
    .all()
    .map((w) => ({
      id: w.id,
      name: w.name,
      coordinatorAgentId: w.coordinatorAgentId,
      missionId: w.missionId,
      status: w.status as Workflow['status'],
      createdAt: w.createdAt,
      memberAgentIds: [...new Set(db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, w.id)).all().map((s) => s.agentId))],
    }))
}
