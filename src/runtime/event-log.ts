import type { SqliteClient } from '../main/infra/db/core'
import { REPLICATED_TABLES, type RuntimeEvent } from './protocol'

/**
 * Transactional outbox → append-only event log.
 *
 * Triggers record every insert/update/delete of the replicated tables in `rt_outbox`
 * within the same transaction as the change itself: no code path can modify an entity
 * without producing an event. `flush()` turns outbox rows into numbered events carrying
 * the row's full current state (event-carried state transfer), in commit order.
 */
export const RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS rt_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_key TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS rt_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, tbl TEXT, row_key TEXT, deleted INTEGER NOT NULL DEFAULT 0, data TEXT);
CREATE INDEX IF NOT EXISTS rt_events_at_idx ON rt_events (at);
CREATE TABLE IF NOT EXISTS rt_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT, cursor INTEGER NOT NULL DEFAULT 0, revoked_at TEXT);
CREATE TABLE IF NOT EXISTS rt_requests (id TEXT PRIMARY KEY, client_id TEXT, method TEXT NOT NULL, result TEXT, error TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rt_sync (kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0, data TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id));
CREATE TABLE IF NOT EXISTS rt_artifacts (id TEXT PRIMARY KEY, mission_id TEXT, agent_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, rel_path TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rt_artifacts_mission_idx ON rt_artifacts (mission_id);
CREATE TABLE IF NOT EXISTS rt_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

const keyExpr = (cols: string[], alias: 'NEW' | 'OLD') => cols.map((c) => `${alias}.${c}`).join(` || '|' || `)

export function outboxTriggers(): string {
  const out: string[] = []
  for (const [tbl, cols] of Object.entries(REPLICATED_TABLES)) {
    out.push(`CREATE TRIGGER IF NOT EXISTS rt_out_${tbl}_i AFTER INSERT ON ${tbl} BEGIN INSERT INTO rt_outbox (tbl, row_key) VALUES ('${tbl}', ${keyExpr(cols, 'NEW')}); END;`)
    out.push(`CREATE TRIGGER IF NOT EXISTS rt_out_${tbl}_u AFTER UPDATE ON ${tbl} BEGIN INSERT INTO rt_outbox (tbl, row_key) VALUES ('${tbl}', ${keyExpr(cols, 'NEW')}); END;`)
    out.push(`CREATE TRIGGER IF NOT EXISTS rt_out_${tbl}_d AFTER DELETE ON ${tbl} BEGIN INSERT INTO rt_outbox (tbl, row_key, deleted) VALUES ('${tbl}', ${keyExpr(cols, 'OLD')}, 1); END;`)
  }
  return out.join('\n')
}

interface EventRow {
  seq: number
  at: string
  kind: string
  tbl: string | null
  row_key: string | null
  deleted: number
  data: string | null
}

const toEvent = (r: EventRow): RuntimeEvent =>
  r.kind === 'entity'
    ? { seq: r.seq, at: r.at, kind: 'entity', table: r.tbl!, key: r.row_key!, deleted: Boolean(r.deleted), row: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : null }
    : { seq: r.seq, at: r.at, kind: 'runtime', data: r.data ? (JSON.parse(r.data) as Record<string, unknown>) : {} }

/** Plain object (node:sqlite returns null-prototype rows). */
const plain = (r: unknown): Record<string, unknown> => ({ ...(r as Record<string, unknown>) })

export class EventLog {
  constructor(
    private sqlite: SqliteClient,
    private now: () => number = Date.now,
  ) {}

  install(): void {
    this.sqlite.exec(RUNTIME_SCHEMA)
    this.sqlite.exec(outboxTriggers())
  }

  private loadRow(tbl: string, key: string): Record<string, unknown> | null {
    const cols = REPLICATED_TABLES[tbl]!
    const parts = key.split('|')
    const where = cols.map((c) => `${c} = ?`).join(' AND ')
    const r = this.sqlite.prepare(`SELECT * FROM ${tbl} WHERE ${where}`).get(...parts)
    return r ? plain(r) : null
  }

  /**
   * Publishes pending outbox rows. Several changes of one row in a batch become one event
   * at the position of the first change (parents before children) carrying the latest state.
   */
  flush(): RuntimeEvent[] {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare('SELECT id, tbl, row_key, deleted FROM rt_outbox ORDER BY id LIMIT 2000').all() as { id: number; tbl: string; row_key: string; deleted: number }[]
      if (!rows.length) return []
      const at = new Date(this.now()).toISOString()
      const insert = this.sqlite.prepare('INSERT INTO rt_events (at, kind, tbl, row_key, deleted, data) VALUES (?, ?, ?, ?, ?, ?)')
      const seen = new Set<string>()
      const out: RuntimeEvent[] = []
      for (const r of rows) {
        const k = `${r.tbl}\u0000${r.row_key}`
        if (seen.has(k)) continue
        seen.add(k)
        const row = this.loadRow(r.tbl, r.row_key)
        const deleted = !row
        const res = insert.run(at, 'entity', r.tbl, r.row_key, deleted ? 1 : 0, row ? JSON.stringify(row) : null)
        out.push({ seq: Number(res.lastInsertRowid), at, kind: 'entity', table: r.tbl, key: r.row_key, deleted, row })
      }
      this.sqlite.prepare('DELETE FROM rt_outbox WHERE id <= ?').run(rows.at(-1)!.id)
      return out
    })()
  }

  /** A runtime lifecycle fact (started, client paired, artifact skipped…). */
  append(data: Record<string, unknown>): RuntimeEvent {
    const at = new Date(this.now()).toISOString()
    const res = this.sqlite.prepare('INSERT INTO rt_events (at, kind, data) VALUES (?, ?, ?)').run(at, 'runtime', JSON.stringify(data))
    return { seq: Number(res.lastInsertRowid), at, kind: 'runtime', data }
  }

  since(cursor: number, limit = 1000): RuntimeEvent[] {
    return (this.sqlite.prepare('SELECT * FROM rt_events WHERE seq > ? ORDER BY seq LIMIT ?').all(cursor, limit) as EventRow[]).map(toEvent)
  }

  bounds(): { firstSeq: number; lastSeq: number } {
    const r = this.sqlite.prepare('SELECT MIN(seq) AS f, MAX(seq) AS l FROM rt_events').get() as { f: number | null; l: number | null }
    // AUTOINCREMENT never reuses numbers: after a prune, firstSeq tells clients what is gone.
    const seqRow = this.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'rt_events'").get() as { seq: number } | undefined
    return { firstSeq: r.f ?? (seqRow?.seq ?? 0) + 1, lastSeq: r.l ?? seqRow?.seq ?? 0 }
  }

  /**
   * Consistent picture of the replicated tables (for a client whose cursor fell behind the
   * retained log): taken in one read transaction with the log position it corresponds to.
   */
  snapshot(tables: string[], limit: number): { tables: Record<string, Record<string, unknown>[]>; lastSeq: number } {
    this.flush()
    return this.sqlite.transaction(() => {
      const out: Record<string, Record<string, unknown>[]> = {}
      for (const t of tables) {
        if (!REPLICATED_TABLES[t]) continue
        out[t] = (this.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid DESC LIMIT ?`).all(limit) as unknown[]).map(plain).reverse()
      }
      return { tables: out, lastSeq: this.bounds().lastSeq }
    })()
  }

  /** Drops events older than `days` that every active client has already received. */
  prune(days: number): number {
    // A client away for more than 90 days no longer holds the log back: it gets a snapshot when it returns.
    const activeSince = new Date(this.now() - 90 * 86400_000).toISOString()
    const minCursor = (this.sqlite.prepare('SELECT MIN(cursor) AS c FROM rt_clients WHERE revoked_at IS NULL AND COALESCE(last_seen_at, created_at) >= ?').get(activeSince) as { c: number | null }).c ?? Number.MAX_SAFE_INTEGER
    const before = new Date(this.now() - days * 86400_000).toISOString()
    return this.sqlite.prepare('DELETE FROM rt_events WHERE at < ? AND seq <= ?').run(before, minCursor).changes
  }
}
