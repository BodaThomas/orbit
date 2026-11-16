import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SqliteClient } from '../main/infra/db/core'
import { newId } from '../main/core/util'
import type { ArtifactMeta } from './protocol'

export interface ArtifactPolicy {
  maxFileBytes: number
  maxMissionBytes: number
  quotaBytes: number
}

export const DEFAULT_ARTIFACT_POLICY: ArtifactPolicy = { maxFileBytes: 5 * 1024 * 1024, maxMissionBytes: 50 * 1024 * 1024, quotaBytes: 2 * 1024 * 1024 * 1024 }
/** Content returned per artifact.get call (base64 travels over the line protocol). */
export const CHUNK_BYTES = 1024 * 1024

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const safeName = (n: string) => basename(n).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'fichier'

/**
 * Results a mission leaves behind, stored under <home>/artifacts/<mission>/ with their
 * SHA-256. Clients only ever name an artifact id: the path is looked up server-side and
 * must stay inside the artifacts folder. Nothing is deleted automatically: when the quota
 * is reached, new artifacts are recorded as « skipped_quota ».
 */
export class ArtifactStore {
  readonly root: string

  constructor(
    private sqlite: SqliteClient,
    home: string,
    private policy: ArtifactPolicy = DEFAULT_ARTIFACT_POLICY,
    private now: () => number = Date.now,
  ) {
    this.root = join(home, 'artifacts')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }

  private usedBytes(): number {
    return (this.sqlite.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM rt_artifacts WHERE status = 'stored'").get() as { n: number }).n
  }

  private record(a: Omit<ArtifactMeta, 'createdAt'> & { relPath: string | null }): ArtifactMeta {
    const createdAt = new Date(this.now()).toISOString()
    this.sqlite.prepare('INSERT INTO rt_artifacts (id, mission_id, agent_id, name, kind, size, sha256, rel_path, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(a.id, a.missionId, a.agentId, a.name, a.kind, a.size, a.sha256, a.relPath, a.status, createdAt)
    const { relPath: _r, ...meta } = a
    return { ...meta, createdAt }
  }

  /** Already collected for this mission (since `since`: the current execution, so a follow-up gets its own). */
  hasFor(missionId: string, since?: string | null): boolean {
    return since
      ? Boolean(this.sqlite.prepare('SELECT 1 FROM rt_artifacts WHERE mission_id = ? AND created_at >= ? LIMIT 1').get(missionId, since))
      : Boolean(this.sqlite.prepare('SELECT 1 FROM rt_artifacts WHERE mission_id = ? LIMIT 1').get(missionId))
  }

  /**
   * Called once when a mission ends: its report (final text) and the files it changed
   * inside its workspace (never outside, never through a symlink).
   */
  collect(m: { id: string; agentId: string; result: string | null; workspace: string | null }, changedPaths: string[], executionStartedAt?: string | null): ArtifactMeta[] {
    if (this.hasFor(m.id, executionStartedAt)) return []
    const out: ArtifactMeta[] = []
    const dir = join(this.root, m.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let missionBytes = 0
    const store = (name: string, kind: ArtifactMeta['kind'], data: Buffer) => {
      const id = newId()
      const base = { id, missionId: m.id, agentId: m.agentId, name, kind, size: data.length, sha256: sha256(data) }
      if (data.length > this.policy.maxFileBytes || missionBytes + data.length > this.policy.maxMissionBytes) return out.push(this.record({ ...base, status: 'skipped_size', relPath: null }))
      if (this.usedBytes() + data.length > this.policy.quotaBytes) return out.push(this.record({ ...base, status: 'skipped_quota', relPath: null }))
      // Unique per artifact: a follow-up's files never overwrite the previous execution's.
      const rel = join(m.id, `${id}-${safeName(name)}`)
      writeFileSync(join(this.root, rel), data, { mode: 0o600 })
      missionBytes += data.length
      out.push(this.record({ ...base, status: 'stored', relPath: rel }))
    }
    if (m.result) store('rapport.md', 'report', Buffer.from(m.result))
    if (m.workspace && existsSync(m.workspace)) {
      const ws = realpathSync(m.workspace)
      const seen = new Set<string>()
      for (const p of [...new Set(changedPaths)].slice(0, 200)) {
        const abs = resolve(ws, p)
        if (!isAbsolute(abs) || relative(ws, abs).startsWith('..') || !existsSync(abs)) continue
        const st = lstatSync(abs)
        if (!st.isFile() || st.isSymbolicLink()) continue
        const real = realpathSync(abs)
        // Engines report relative paths, snapshots absolute ones: one artifact per real file.
        if (!real.startsWith(ws + sep) || seen.has(real)) continue
        seen.add(real)
        if (st.size > this.policy.maxFileBytes) {
          out.push(this.record({ id: newId(), missionId: m.id, agentId: m.agentId, name: relative(ws, real), kind: 'file', size: st.size, sha256: '', status: 'skipped_size', relPath: null }))
          continue
        }
        const data = readFileSync(real)
        store(relative(ws, real), 'file', data)
      }
    }
    return out
  }

  list(missionId?: string): ArtifactMeta[] {
    const rows = (missionId ? this.sqlite.prepare('SELECT * FROM rt_artifacts WHERE mission_id = ? ORDER BY created_at').all(missionId) : this.sqlite.prepare('SELECT * FROM rt_artifacts ORDER BY created_at DESC LIMIT 500').all()) as Record<string, unknown>[]
    return rows.map((r) => ({ id: String(r.id), missionId: (r.mission_id as string) ?? null, agentId: (r.agent_id as string) ?? null, name: String(r.name), kind: r.kind as ArtifactMeta['kind'], size: Number(r.size), sha256: String(r.sha256), status: r.status as ArtifactMeta['status'], createdAt: String(r.created_at) }))
  }

  /** Reads one chunk of a stored artifact, verifying its hash on the first chunk. */
  read(id: string, offset = 0): { data: string; offset: number; size: number; done: boolean; sha256: string } {
    const r = this.sqlite.prepare('SELECT * FROM rt_artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) throw new Error('Artefact inconnu.')
    if (r.status !== 'stored' || !r.rel_path) throw new Error('Cet artefact n’a pas été conservé (taille ou quota).')
    const abs = resolve(this.root, String(r.rel_path))
    if (!abs.startsWith(realpathSync(this.root) + sep) && !abs.startsWith(this.root + sep)) throw new Error('Emplacement refusé.')
    if (!existsSync(abs)) {
      this.sqlite.prepare("UPDATE rt_artifacts SET status = 'missing' WHERE id = ?").run(id)
      throw new Error('Fichier de l’artefact introuvable sur le serveur.')
    }
    const buf = readFileSync(abs)
    if (offset === 0 && sha256(buf) !== r.sha256) throw new Error('Intégrité de l’artefact non vérifiée (empreinte différente).')
    const chunk = buf.subarray(offset, offset + CHUNK_BYTES)
    return { data: chunk.toString('base64'), offset, size: buf.length, done: offset + chunk.length >= buf.length, sha256: String(r.sha256) }
  }
}

