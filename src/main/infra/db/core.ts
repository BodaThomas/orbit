import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { MIGRATION_SOURCES } from './migrations'
import * as schema from './schema'

export type OrbitDb = BetterSQLite3Database<typeof schema>

/** The subset of a SQLite driver Orbit relies on (better-sqlite3, or node:sqlite through an adapter). */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

export interface SqliteClient {
  prepare(sql: string): SqliteStatement
  exec(sql: string): unknown
  pragma(statement: string): unknown
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R
  close(): void
}

export interface DatabaseHandle {
  db: OrbitDb
  sqlite: SqliteClient
  driver: 'better-sqlite3' | 'node:sqlite'
  close(): void
}

export function listMigrations(): { name: string; sql: string }[] {
  return Object.entries(MIGRATION_SOURCES)
    .map(([path, sql]) => ({ name: path.split('/').pop()!.replace(/\.sql$/, ''), sql }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Applies pending migrations inside a transaction each. Idempotent. */
export function runMigrations(sqlite: SqliteClient): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __orbit_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
  const applied = new Set((sqlite.prepare('SELECT name FROM __orbit_migrations').all() as { name: string }[]).map((r) => r.name))
  const ran: string[] = []
  for (const m of listMigrations()) {
    if (applied.has(m.name)) continue
    const statements = m.sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)
    sqlite.transaction(() => {
      for (const statement of statements) sqlite.exec(statement)
      sqlite.prepare('INSERT INTO __orbit_migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString())
    })()
    ran.push(m.name)
  }
  return ran
}

/** Latest migration name: two databases with the same value share one schema. */
export function schemaVersion(): string {
  return listMigrations().at(-1)?.name ?? 'none'
}

export function wrapDatabase(sqlite: SqliteClient, driver: DatabaseHandle['driver']): DatabaseHandle {
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  runMigrations(sqlite)
  // drizzle's better-sqlite3 driver only uses the SqliteClient surface above.
  const db = drizzle(sqlite as never, { schema })
  return { db, sqlite, driver, close: () => sqlite.close() }
}
