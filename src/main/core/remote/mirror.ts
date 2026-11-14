import type { InvalidateScope } from '@shared/ipc'
import type { ExecutionEvent, OrbitNotification } from '@shared/types'
import type { SqliteClient } from '../../infra/db/core'
import type { RuntimeEvent } from '../../../runtime/protocol'

/**
 * Orbit Desktop's synced copy of what a runtime executes.
 *
 * Runtime rows land in the usual tables (so every existing screen shows them), marked with
 * their machine. The runtime is the source of truth: a row is replaced by its newer state,
 * never edited here. Applying the same event twice changes nothing.
 */

interface TableRule {
  /** Destination table on the Mac. */
  to: string
  key: string[]
  /** Column set on the Mac copy to the owning machine. */
  marker?: string
  /** Columns never overwritten once the row exists. */
  immutable?: string[]
  /** Only these columns are updated, and only on existing rows owned by the machine. */
  stateOnly?: { columns: string[]; ownerColumn: string }
  /** Rename runtime columns. */
  rename?: Record<string, string>
  insertOnly?: boolean
}

const RULES: Record<string, TableRule> = {
  missions: { to: 'missions', key: ['id'], marker: 'remote_machine_id', immutable: ['short_id', 'created_at'] },
  mission_executions: { to: 'mission_executions', key: ['id'] },
  execution_events: { to: 'execution_events', key: ['id'], insertOnly: true },
  tool_calls: { to: 'tool_calls', key: ['id'] },
  approval_requests: { to: 'approval_requests', key: ['id'], marker: 'machine_id' },
  file_changes: { to: 'file_changes', key: ['id'] },
  file_inventories: { to: 'file_inventories', key: ['id'] },
  constellation_runs: { to: 'constellation_runs', key: ['id'], marker: 'machine_id' },
  mission_dependencies: { to: 'mission_dependencies', key: ['mission_id', 'depends_on_mission_id'], insertOnly: true },
  execution_handoffs: { to: 'execution_handoffs', key: ['id'] },
  agent_workspaces: { to: 'agent_workspaces', key: ['id'] },
  automation_definitions: { to: 'automation_definitions', key: ['id'], stateOnly: { columns: ['next_run_at', 'last_run_at', 'status'], ownerColumn: 'scheduler_owner' } },
  automation_runs: { to: 'automation_runs', key: ['id'], marker: 'machine_id' },
  usage_records: { to: 'usage_records', key: ['id'], marker: 'machine_id' },
  activity_events: { to: 'activity_events', key: ['id'], insertOnly: true },
  security_audit_events: { to: 'security_audit_events', key: ['id'], insertOnly: true },
  rt_artifacts: { to: 'remote_artifacts', key: ['id'], marker: 'machine_id', rename: { rel_path: '' } },
}

const SCOPES: Record<string, InvalidateScope[]> = {
  missions: ['missions', 'agents'],
  mission_executions: ['missions'],
  execution_events: ['missions'],
  tool_calls: ['missions'],
  approval_requests: ['approvals', 'missions', 'agents'],
  file_changes: ['missions'],
  file_inventories: ['missions'],
  constellation_runs: ['constellations', 'missions'],
  mission_dependencies: ['constellations'],
  execution_handoffs: ['constellations'],
  agent_workspaces: ['constellations'],
  automation_definitions: ['automations'],
  automation_runs: ['automations'],
  usage_records: ['usage'],
  activity_events: ['activity'],
  security_audit_events: ['security'],
  rt_artifacts: ['missions'],
}

export interface MirrorNotice {
  kind: OrbitNotification['kind']
  title: string
  body: string
  route: string | null
  dedupeKey: string
}

export interface ApplyResult {
  scopes: Set<InvalidateScope>
  notices: MirrorNotice[]
  /** New execution events (re-emitted live when not catching up). */
  executionEvents: ExecutionEvent[]
  errors: string[]
}

export class RemoteMirror {
  private columns = new Map<string, Set<string>>()

  constructor(
    private sqlite: SqliteClient,
    private names: { agent: (id: string) => string; machine: (id: string) => string },
  ) {}

  private cols(table: string): Set<string> {
    let c = this.columns.get(table)
    if (!c) {
      c = new Set((this.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name))
      this.columns.set(table, c)
    }
    return c
  }

  private current(table: string, key: string[], values: unknown[]): Record<string, unknown> | null {
    const r = this.sqlite.prepare(`SELECT * FROM ${table} WHERE ${key.map((k) => `${k} = ?`).join(' AND ')}`).get(...values)
    return r ? { ...(r as Record<string, unknown>) } : null
  }

  /** Applies a batch in one transaction; one bad row never blocks the others. */
  apply(machineId: string, events: RuntimeEvent[]): ApplyResult {
    const res: ApplyResult = { scopes: new Set(), notices: [], executionEvents: [], errors: [] }
    this.sqlite.transaction(() => {
      for (const e of events) {
        if (e.kind !== 'entity' || !e.table) continue
        const rule = RULES[e.table]
        if (!rule) continue
        try {
          this.sqlite.transaction(() => this.applyOne(machineId, e, rule, res))()
          for (const s of SCOPES[e.table] ?? []) res.scopes.add(s)
        } catch (err) {
          res.errors.push(`${e.table} ${e.key}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })()
    return res
  }

  private applyOne(machineId: string, e: RuntimeEvent, rule: TableRule, res: ApplyResult) {
    const keyValues = (e.key ?? '').split('|')
    if (e.deleted || !e.row) {
      if (rule.stateOnly) return
      const where = rule.key.map((k) => `${k} = ?`).join(' AND ')
      // Only rows this machine owns can disappear through it.
      const markerCheck = rule.marker ? ` AND ${rule.marker} = ?` : ''
      this.sqlite.prepare(`DELETE FROM ${rule.to} WHERE ${where}${markerCheck}`).run(...keyValues, ...(rule.marker ? [machineId] : []))
      return
    }
    const destCols = this.cols(rule.to)
    const row: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e.row)) {
      const name = rule.rename && k in rule.rename ? rule.rename[k] : k
      if (name && destCols.has(name)) row[name] = v
    }
    if (rule.marker) row[rule.marker] = machineId

    if (rule.stateOnly) {
      const set = rule.stateOnly.columns.filter((c) => c in row)
      if (!set.length) return
      this.sqlite.prepare(`UPDATE ${rule.to} SET ${set.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND ${rule.stateOnly.ownerColumn} = ?`).run(...set.map((c) => row[c]), keyValues[0], machineId)
      return
    }

    const before = this.current(rule.to, rule.key, keyValues)
    if (before && rule.marker && before[rule.marker] !== machineId) throw new Error('ligne appartenant à une autre origine : ignorée')
    if (before && rule.insertOnly) return
    const cols = Object.keys(row)
    if (!before) {
      try {
        this.sqlite.prepare(`INSERT INTO ${rule.to} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]))
      } catch (err) {
        // Short ids are unique per database: a runtime-made mission may collide with a local one.
        if (rule.to === 'missions' && /short_id/.test(String(err))) {
          row.short_id = `${String(row.short_id)}·${this.names.machine(machineId).slice(0, 3).toUpperCase()}`
          this.sqlite.prepare(`INSERT INTO ${rule.to} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]))
        } else throw err
      }
    } else {
      const upd = cols.filter((c) => !rule.key.includes(c) && !(rule.immutable ?? []).includes(c))
      if (upd.length) this.sqlite.prepare(`UPDATE ${rule.to} SET ${upd.map((c) => `${c} = ?`).join(', ')} WHERE ${rule.key.map((k) => `${k} = ?`).join(' AND ')}`).run(...upd.map((c) => row[c]), ...keyValues)
    }
    this.derive(machineId, e.table!, before, row, res)
  }

  /** Notifications and live signals from real transitions only (old state → new state). */
  private derive(machineId: string, table: string, before: Record<string, unknown> | null, row: Record<string, unknown>, res: ApplyResult) {
    const machine = this.names.machine(machineId)
    const changed = (col: string) => !before || before[col] !== row[col]
    if (table === 'missions' && changed('status')) {
      const status = String(row.status)
      const agent = this.names.agent(String(row.agent_id))
      const title = String(row.title)
      // Sub-missions of a constellation are summarised by the constellation itself.
      if (row.constellation_run_id && Number(row.depth ?? 0) > 0) return
      if (status === 'done') res.notices.push({ kind: 'mission_done', title: `${agent} a terminé sur ${machine}`, body: title, route: `/missions/${String(row.id)}`, dedupeKey: `remote:mission:${String(row.id)}:done:${String(row.finished_at ?? '')}` })
      else if (status === 'failed') {
        const budget = /budget/i.test(String(row.error ?? ''))
        res.notices.push({ kind: budget ? 'budget' : 'mission_failed', title: budget ? `Budget atteint sur ${machine}` : `Échec sur ${machine} · ${agent}`, body: String(row.error ?? title).slice(0, 200), route: `/missions/${String(row.id)}`, dedupeKey: `remote:mission:${String(row.id)}:failed:${String(row.finished_at ?? '')}` })
      }
    }
    if (table === 'approval_requests' && row.status === 'pending' && !before) {
      res.notices.push({ kind: 'approval', title: `Accord demandé sur ${machine}`, body: String(row.summary).slice(0, 200), route: row.mission_id ? `/missions/${String(row.mission_id)}` : '/', dedupeKey: `remote:approval:${String(row.id)}` })
    }
    if (table === 'constellation_runs' && changed('status') && ['done', 'failed'].includes(String(row.status))) {
      res.notices.push({ kind: row.status === 'done' ? 'mission_done' : 'mission_failed', title: row.status === 'done' ? `Constellation terminée sur ${machine}` : `Constellation en échec sur ${machine}`, body: String(row.status === 'done' ? row.goal : (row.error ?? row.goal)).slice(0, 200), route: `/constellations/runs/${String(row.id)}`, dedupeKey: `remote:run:${String(row.id)}:${String(row.status)}` })
    }
    if (table === 'automation_runs' && changed('status') && row.status === 'pending_confirmation') {
      res.notices.push({ kind: 'approval', title: `Exécution manquée sur ${machine}`, body: String(row.note ?? 'Confirmez ou ignorez cette exécution.').slice(0, 200), route: `/automations?run=${String(row.id)}`, dedupeKey: `remote:autorun:${String(row.id)}:confirm` })
    }
    if (table === 'execution_events' && !before) {
      let data: Record<string, unknown> | null
      try {
        data = typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : null
      } catch {
        data = null
      }
      res.executionEvents.push({ id: String(row.id), missionId: String(row.mission_id), executionId: String(row.execution_id), type: row.type as ExecutionEvent['type'], message: String(row.message), data, createdAt: String(row.created_at) } as ExecutionEvent)
    }
  }

  /** Replaces the copy with a consistent snapshot (cursor fell behind the runtime's retained log). */
  applySnapshot(machineId: string, tables: Record<string, Record<string, unknown>[]>, at: string): ApplyResult {
    const events: RuntimeEvent[] = []
    let seq = 0
    // Parents first: the replicated table order is causal.
    for (const t of Object.keys(RULES)) for (const row of tables[t] ?? []) events.push({ seq: ++seq, at, kind: 'entity', table: t, key: RULES[t]!.key.map((k) => String(row[k])).join('|'), deleted: false, row })
    const res = this.apply(machineId, events)
    res.notices = [] // a resync reports state, it doesn't replay old news
    return res
  }
}
