import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { bwrapAvailable, bwrapConfine } from './bwrap'

/**
 * Level 3 on the host Mac: an Orbit-owned Seatbelt (sandbox-exec) profile wrapped around
 * the *whole* engine process tree. Unlike the engines' own sandboxes (which restrict
 * writes), this profile also denies **reads** of the home folder, except the workspace
 * and the few directories the engine itself needs to authenticate and keep sessions.
 *
 * The kernel enforces it for every child process (shell commands included) and it
 * follows symlinks. It is only offered once `selfTest()` has proven, on this machine,
 * that an outside read is refused and an inside read works.
 *
 * Residual exposure (documented in docs/SECURITY.md): the engine's own state directory
 * (~/.claude, ~/.codex - which may hold its login), the macOS keychain database files
 * (encrypted) and system folders outside $HOME stay readable.
 */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export interface ConfinementSpec {
  workspace: string
  /** Extra read-only paths under $HOME the engine needs (its binary, its config). */
  readable: string[]
  /** Paths the process tree may write besides the workspace and temp dirs. */
  writable: string[]
  /** Allow writing the workspace at all (the engine's own approvals still apply). */
  workspaceWritable: boolean
  home?: string
}

const q = (p: string) => JSON.stringify(p)
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export function seatbeltAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC)
}

/** Builds the SBPL profile. Later rules win in SBPL, so allows come after the deny. */
export function buildProfile(spec: ConfinementSpec): string {
  const home = real(spec.home ?? homedir())
  const ws = real(spec.workspace)
  const tmp = [real(tmpdir()), '/private/tmp', '/private/var/folders']
  const readable = [...new Set([ws, ...spec.readable.map(real), ...spec.readable])]
  const writable = [...new Set([...(spec.workspaceWritable ? [ws] : []), ...spec.writable.map(real), ...spec.writable])]
  return [
    '(version 1)',
    '(allow default)',
    // Nothing under $HOME is readable or writable…
    `(deny file-read* file-write* (subpath ${q(home)}))`,
    // …except listing $HOME itself, the workspace and what the engine needs.
    `(allow file-read-metadata (literal ${q(home)}))`,
    `(allow file-read* ${readable.map((p) => `(subpath ${q(p)})`).join(' ')})`,
    // Writes: only the workspace (if allowed), engine state and temp dirs.
    `(deny file-write* (require-not (require-any ${[...writable.map((p) => `(subpath ${q(p)})`), ...tmp.map((p) => `(subpath ${q(p)})`), '(literal "/dev/null")', '(literal "/dev/tty")', '(regex #"^/dev/fd/")', '(regex #"^/dev/ttys")'].join(' ')})))`,
    // $HOME stays closed even if it happens to live under a temp dir (self-test)…
    `(deny file-write* (subpath ${q(home)}))`,
    // …then the workspace and engine state are reopened.
    ...(writable.length ? [`(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')})`] : []),
  ].join('\n')
}

/** Seatbelt on macOS, bubblewrap on Linux. */
export const confinementAvailable = (): boolean => seatbeltAvailable() || bwrapAvailable()

/** Wraps a command so it runs confined (Seatbelt on macOS, bubblewrap on Linux). */
export function confine(command: string, args: string[], spec: ConfinementSpec): { command: string; args: string[] } {
  if (process.platform === 'linux') return bwrapConfine(command, args, spec)
  return { command: SANDBOX_EXEC, args: ['-p', buildProfile(spec), command, ...args] }
}

export interface ConfinementProof {
  ok: boolean
  checkedAt: string
  /** One line per check, in French, shown in Settings → Sécurité. */
  checks: { label: string; ok: boolean }[]
  error: string | null
}

/**
 * Empirical proof on this machine, with throw-away files only (never real secrets):
 * a fake « home » with a fake secret, a fake SSH key and a symlink pointing at it from
 * inside the workspace. Each check runs a real subprocess under the generated profile.
 */
export function selfTest(): ConfinementProof {
  const checkedAt = new Date().toISOString()
  if (!seatbeltAvailable()) return { ok: false, checkedAt, checks: [], error: 'sandbox-exec indisponible sur ce système.' }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-confine-')))
  try {
    const home = join(root, 'home')
    const ws = join(home, 'projet')
    const engineDir = join(home, '.engine')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(ws, { recursive: true })
    mkdirSync(engineDir, { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE-PRIVATE-KEY\n')
    writeFileSync(join(home, 'secret.txt'), 'FAKE-SECRET\n')
    writeFileSync(join(ws, 'inside.txt'), 'inside\n')
    writeFileSync(join(engineDir, 'state'), 'engine\n')
    symlinkSync(join(home, 'secret.txt'), join(ws, 'lien.txt'))
    const spec: ConfinementSpec = { workspace: ws, readable: [engineDir], writable: [], workspaceWritable: true, home }
    const run = (cmd: string, args: string[]) => {
      const c = confine(cmd, args, spec)
      return spawnSync(c.command, c.args, { cwd: ws, encoding: 'utf8', timeout: 10_000 })
    }
    const checks = [
      { label: 'Lecture dans le dossier autorisé', ok: run('/bin/cat', [join(ws, 'inside.txt')]).stdout === 'inside\n' },
      { label: 'Lecture de l’état du moteur', ok: run('/bin/cat', [join(engineDir, 'state')]).status === 0 },
      { label: 'Lecture hors du dossier refusée', ok: run('/bin/cat', [join(home, 'secret.txt')]).status !== 0 },
      { label: 'Clé SSH factice illisible', ok: run('/bin/cat', [join(home, '.ssh', 'id_ed25519')]).status !== 0 },
      { label: 'Lien symbolique vers l’extérieur bloqué', ok: run('/bin/cat', [join(ws, 'lien.txt')]).status !== 0 },
      { label: 'Sous-processus (sh -c) confiné', ok: run('/bin/sh', ['-c', `cat ${q(join(home, 'secret.txt'))}`]).status !== 0 },
      { label: 'Écriture hors du dossier refusée', ok: run('/bin/sh', ['-c', `echo x > ${q(join(home, 'pirate.txt'))}`]).status !== 0 && !existsSync(join(home, 'pirate.txt')) },
      { label: 'Écriture dans le dossier autorisée', ok: run('/bin/sh', ['-c', `echo x > ${q(join(ws, 'ok.txt'))}`]).status === 0 },
    ]
    return { ok: checks.every((c) => c.ok), checkedAt, checks, error: null }
  } catch (err) {
    return { ok: false, checkedAt, checks: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Developer toolchains installed under $HOME (node via mise/nvm, cargo, bun…): readable so
 * that `npm test` keeps working. Package caches are writable. Listed in the UI.
 */
export function toolchainPaths(): { readable: string[]; writable: string[] } {
  const home = homedir()
  const fromPath = (process.env.PATH ?? '')
    .split(':')
    .filter((p) => p.startsWith(`${home}/`) && !p.startsWith(`${home}/Projets`))
    .map((p) => p.replace(/\/(bin|shims)$/, ''))
  const known = ['.local/share/mise', '.local/bin', '.nvm', '.volta', '.cargo', '.rustup', '.bun', '.deno', '.pyenv', '.rbenv', '.sdkman', '.gradle', '.m2'].map((d) => join(home, d))
  const caches = ['.npm', '.cache', 'Library/Caches', '.yarn', '.pnpm-store'].map((d) => join(home, d))
  return { readable: [...new Set([...fromPath, ...known, ...caches])].filter(existsSync), writable: caches.filter(existsSync) }
}

/** What each engine needs to read under $HOME to log in and keep its sessions. */
export function engineReadablePaths(engine: 'claude-code' | 'claude-agent' | 'codex', extra: { configDir?: string; binary?: string } = {}): { readable: string[]; writable: string[] } {
  const home = homedir()
  const bin = extra.binary ? [extra.binary.replace(/\/[^/]+$/, '')] : []
  switch (engine) {
    case 'claude-code':
      return {
        readable: [join(home, '.claude'), join(home, '.claude.json'), join(home, '.local', 'share', 'claude'), join(home, '.local', 'bin'), join(home, 'Library', 'Keychains'), ...bin],
        writable: [join(home, '.claude'), join(home, '.claude.json'), join(home, '.claude.json.lock'), join(home, 'Library', 'Keychains')],
      }
    case 'claude-agent':
      return { readable: [...(extra.configDir ? [extra.configDir] : []), ...bin], writable: extra.configDir ? [extra.configDir] : [] }
    case 'codex':
      return { readable: [process.env.CODEX_HOME ?? join(home, '.codex'), ...bin], writable: [process.env.CODEX_HOME ?? join(home, '.codex')] }
  }
}

/** Confinement spec for one engine run, or null when the companion runs in standard mode. */
export function engineConfinement(
  engine: 'claude-code' | 'claude-agent' | 'codex',
  policy: { workspace: string; isolation: 'standard' | 'strict'; permissions: { writeFiles: boolean }; writeScopes?: string[] },
  extra: { configDir?: string; binary?: string } = {},
): ConfinementSpec | null {
  if (policy.isolation !== 'strict') return null
  const e = engineReadablePaths(engine, extra)
  const t = toolchainPaths()
  // A scoped sub-mission keeps read access to the whole folder but writes only its scopes.
  const scopes = policy.permissions.writeFiles ? (policy.writeScopes ?? []) : []
  return { workspace: policy.workspace, readable: [...e.readable, ...t.readable], writable: [...e.writable, ...t.writable, ...scopes], workspaceWritable: policy.permissions.writeFiles && !scopes.length }
}
