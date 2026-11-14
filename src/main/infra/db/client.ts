import { chmodSync } from 'node:fs'
import Database from 'better-sqlite3'
import { wrapDatabase, type DatabaseHandle, type SqliteClient } from './core'

export { listMigrations, runMigrations, schemaVersion, type DatabaseHandle, type OrbitDb, type SqliteClient } from './core'

/** Orbit Desktop's database (better-sqlite3, rebuilt for Electron). */
export function openDatabase(file: string): DatabaseHandle {
  const sqlite = new Database(file)
  // The database holds conversations and audit logs: owner-only, like its folder.
  if (file !== ':memory:') {
    for (const f of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        chmodSync(f, 0o600)
      } catch {
        /* created lazily */
      }
    }
  }
  return wrapDatabase(sqlite as unknown as SqliteClient, 'better-sqlite3')
}
