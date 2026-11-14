import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { unifiedDiff } from './diff'

const run = promisify(execFile)

/**
 * Before/after snapshots of a workspace, so Orbit sees files changed by *any* means
 * (patches, shell redirections, scripts) - not only what the engine reports.
 *
 * Git projects: the working tree is written to a throw-away index (GIT_INDEX_FILE in a
 * temp dir) and turned into a tree object. Nothing the user owns changes: not their
 * index, not their stash, no ref, no checkout. Only loose objects are added to .git
 * (garbage-collected later by Git). Other folders: size/mtime/hash fingerprints.
 */

export interface FileDelta {
  path: string
  kind: 'add' | 'update' | 'delete'
  diff: string | null
}

export interface SnapshotResult {
  method: 'git' | 'scan'
  changes: FileDelta[]
  complete: boolean
  notes: string[]
}

export interface Snapshot {
  method: 'git' | 'scan'
  /** Computes what changed since this snapshot. */
  diff(): Promise<SnapshotResult>
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.venv', 'venv', '__pycache__', '.turbo', '.cache', 'target', 'DerivedData', '.DS_Store'])
const MAX_FILES = 20_000
const MAX_TEXT = 128 * 1024
const MAX_KEPT_BYTES = 32 * 1024 * 1024
const MAX_DIFF = 60_000

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

export async function gitTopLevel(ws: string): Promise<string | null> {
  try {
    return (await git(ws, ['rev-parse', '--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

async function gitTree(ws: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-idx-'))
  const env = { GIT_INDEX_FILE: join(dir, 'index') }
  try {
    try {
      await git(ws, ['read-tree', 'HEAD'], env)
    } catch {
      /* repository without commits: start from an empty index */
    }
    await git(ws, ['add', '-A', '--', '.'], env)
    return (await git(ws, ['write-tree'], env)).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function gitSnapshot(ws: string, top: string): Promise<Snapshot> {
  const before = await gitTree(ws)
  const scope = relative(top, ws) || '.'
  return {
    method: 'git',
    async diff() {
      const notes: string[] = []
      const after = await gitTree(ws)
      const changes: FileDelta[] = []
      if (after !== before) {
        const status = await git(top, ['diff-tree', '-r', '--no-renames', '--name-status', before, after, '--', scope])
        for (const line of status.split('\n').filter(Boolean).slice(0, 500)) {
          const [code, ...rest] = line.split('\t')
          const rel = rest.join('\t')
          const kind = code === 'A' ? 'add' : code === 'D' ? 'delete' : 'update'
          const diff = await git(top, ['diff', '--no-color', '--no-ext-diff', before, after, '--', rel])
            .then((d) => d.slice(0, MAX_DIFF) || null)
            .catch(() => null)
          changes.push({ path: join(top, rel), kind, diff })
        }
      }
      let complete = true
      try {
        const ignored = (await git(ws, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--', '.'])).split('\n').filter(Boolean)
        if (ignored.length) {
          complete = false
          notes.push(`${ignored.length} élément${ignored.length > 1 ? 's' : ''} ignoré${ignored.length > 1 ? 's' : ''} par .gitignore (ex. ${ignored.slice(0, 2).join(', ')}) : non surveillé${ignored.length > 1 ? 's' : ''}.`)
        }
      } catch {
        complete = false
        notes.push('Impossible de lister les fichiers ignorés par Git.')
      }
      return { method: 'git', changes, complete, notes }
    },
  }
}

interface Entry {
  size: number
  mtimeMs: number
  hash: string | null
  text: string | null
}

function scanTree(ws: string): { files: Map<string, Entry>; truncated: boolean; skipped: Set<string> } {
  const files = new Map<string, Entry>()
  const skipped = new Set<string>()
  let kept = 0
  let truncated = false
  const walk = (dir: string) => {
    if (truncated) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full, { throwIfNoEntry: false })
      } catch {
        continue
      }
      if (!st) continue
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) {
          skipped.add(name)
          continue
        }
        walk(full)
      } else if (st.isFile()) {
        if (files.size >= MAX_FILES) {
          truncated = true
          return
        }
        let hash: string | null = null
        let text: string | null = null
        if (st.size <= 4 * 1024 * 1024) {
          const buf = readFileSync(full)
          hash = createHash('sha1').update(buf).digest('hex')
          if (st.size <= MAX_TEXT && kept + st.size <= MAX_KEPT_BYTES && !buf.includes(0)) {
            text = buf.toString('utf8')
            kept += st.size
          }
        }
        files.set(relative(ws, full).split(sep).join('/'), { size: st.size, mtimeMs: st.mtimeMs, hash, text })
      }
    }
  }
  walk(ws)
  return { files, truncated, skipped }
}

function scanSnapshot(ws: string): Snapshot {
  const before = scanTree(ws)
  return {
    method: 'scan',
    async diff() {
      const after = scanTree(ws)
      const changes: FileDelta[] = []
      const differs = (a: Entry, b: Entry) => (a.hash && b.hash ? a.hash !== b.hash : a.size !== b.size || a.mtimeMs !== b.mtimeMs)
      for (const [rel, b] of after.files) {
        const a = before.files.get(rel)
        if (!a) changes.push({ path: join(ws, rel), kind: 'add', diff: b.text != null ? unifiedDiff(rel, '', b.text) : null })
        else if (differs(a, b)) changes.push({ path: join(ws, rel), kind: 'update', diff: a.text != null && b.text != null ? unifiedDiff(rel, a.text, b.text) : null })
      }
      for (const rel of before.files.keys()) if (!after.files.has(rel)) changes.push({ path: join(ws, rel), kind: 'delete', diff: null })
      const notes: string[] = []
      const skipped = new Set([...before.skipped, ...after.skipped])
      if (skipped.size) notes.push(`Dossiers non surveillés : ${[...skipped].slice(0, 5).join(', ')}.`)
      if (before.truncated || after.truncated) notes.push(`Plus de ${MAX_FILES.toLocaleString('fr-FR')} fichiers : inventaire tronqué.`)
      return { method: 'scan', changes: changes.slice(0, 500), complete: !skipped.size && !before.truncated && !after.truncated && changes.length <= 500, notes }
    },
  }
}

/** Takes the « before » snapshot. Never throws: returns null when the folder cannot be read. */
export async function takeSnapshot(ws: string): Promise<Snapshot | null> {
  try {
    const top = await gitTopLevel(ws)
    if (top) return await gitSnapshot(ws, top)
    return scanSnapshot(ws)
  } catch {
    try {
      return scanSnapshot(ws)
    } catch {
      return null
    }
  }
}
