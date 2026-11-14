import { chmodSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { wrapDatabase, type DatabaseHandle, type SqliteClient, type SqliteStatement } from './core'

/**
 * node:sqlite (built into Node ≥ 22.16) exposed with the better-sqlite3 surface the
 * drizzle driver uses. Lets the runtime ship as a single JS file: no native module to
 * compile or download on the server.
 */
type Param = null | number | bigint | string | NodeJS.ArrayBufferView
const norm = (params: unknown[]): Param[] =>
  params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0
    if (p === undefined) return null
    if (p instanceof Date) return p.toISOString()
    return p as Param
  })

class Statement implements SqliteStatement {
  private stmt: StatementSync
  private arrays: StatementSync | null = null

  constructor(
    private db: DatabaseSync,
    private sql: string,
  ) {
    this.stmt = db.prepare(sql)
  }

  run(...params: unknown[]) {
    const r = this.stmt.run(...norm(params))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }

  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...norm(params))
  }

  get(...params: unknown[]): unknown {
    return this.stmt.get(...norm(params))
  }

  /** Array mode (drizzle's typed selects). */
  raw() {
    if (!this.arrays) {
      this.arrays = this.db.prepare(this.sql)
      this.arrays.setReturnArrays(true)
    }
    const s = this.arrays
    return { all: (...p: unknown[]) => s.all(...norm(p)), get: (...p: unknown[]) => s.get(...norm(p)) }
  }
}

export class NodeSqliteClient implements SqliteClient {
  private db: DatabaseSync
  private depth = 0

  constructor(file: string) {
    this.db = new DatabaseSync(file)
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  pragma(statement: string): unknown {
    return this.db.prepare(`PRAGMA ${statement}`).all()
  }

  /** Same contract as better-sqlite3: outermost call is BEGIN/COMMIT, nested calls are savepoints. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const make = (mode: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE') => (...args: A): R => {
      const sp = `orbit_sp_${this.depth}`
      const outer = this.depth === 0
      this.db.exec(outer ? `BEGIN ${mode}` : `SAVEPOINT ${sp}`)
      this.depth++
      try {
        const r = fn(...args)
        this.depth--
        this.db.exec(outer ? 'COMMIT' : `RELEASE ${sp}`)
        return r
      } catch (err) {
        this.depth--
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
        throw err
      }
    }
    const f = make('DEFERRED') as ((...args: A) => R) & Record<'deferred' | 'immediate' | 'exclusive', (...args: A) => R>
    f.deferred = f
    f.immediate = make('IMMEDIATE')
    f.exclusive = make('EXCLUSIVE')
    return f
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }
}

export function openNodeSqliteDatabase(file: string): DatabaseHandle {
  const client = new NodeSqliteClient(file)
  if (file !== ':memory:') chmodSync(file, 0o600)
  return wrapDatabase(client, 'node:sqlite')
}
