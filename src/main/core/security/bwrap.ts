import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfinementProof, ConfinementSpec } from './seatbelt'

/**
 * Level 3 on Linux: bubblewrap (bwrap) around the whole engine process tree, mirroring the
 * macOS Seatbelt profile. In a private mount namespace:
 *  - the whole system is read-only;
 *  - the home folder (which holds the runtime's database, keys, other projects and the
 *    server's SSH keys) is replaced by an empty read-only tmpfs;
 *  - only the project (read-write if allowed) and the engine's own state are mounted back;
 *  - /tmp is private, PID/IPC/UTS namespaces are separate, the sandbox dies with its parent.
 * The network is not cut: the engine itself must reach its model API (command network
 * access is governed by Orbit's policy and the engine's sandbox).
 *
 * Offered only once `bwrapSelfTest()` has proven it on this machine.
 */
export const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']

export function bwrapPath(): string | null {
  if (process.platform !== 'linux') return null
  return BWRAP_CANDIDATES.find((p) => existsSync(p)) ?? null
}

export const bwrapAvailable = (): boolean => bwrapPath() !== null

const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export function bwrapArgs(spec: ConfinementSpec & { hide?: string[] }, command: string, args: string[]): string[] {
  const home = real(spec.home ?? homedir())
  const ws = real(spec.workspace)
  const a = ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']
  a.push('--tmpfs', home)
  for (const h of spec.hide ?? []) if (!h.startsWith(home + '/') && h !== home) a.push('--tmpfs', real(h))
  for (const p of [...new Set(spec.readable.map(real))]) if (p !== ws) a.push('--ro-bind-try', p, p)
  for (const p of [...new Set(spec.writable.map(real))]) if (p !== ws) a.push('--bind-try', p, p)
  a.push(spec.workspaceWritable ? '--bind' : '--ro-bind', ws, ws)
  // The emptied home stays read-only (its mounted sub-folders keep their own mode).
  a.push('--remount-ro', home, '--chdir', ws, '--setenv', 'HOME', home, '--', command, ...args)
  return a
}

export function bwrapConfine(command: string, args: string[], spec: ConfinementSpec & { hide?: string[] }): { command: string; args: string[] } {
  const bin = bwrapPath()
  if (!bin) throw new Error('bubblewrap introuvable : isolation par mission indisponible.')
  return { command: bin, args: bwrapArgs(spec, command, args) }
}

/** Same throw-away checks as the macOS self-test, run for real under bwrap. */
export function bwrapSelfTest(): ConfinementProof {
  const checkedAt = new Date().toISOString()
  if (!bwrapAvailable()) return { ok: false, checkedAt, checks: [], error: 'bubblewrap absent sur ce serveur.' }
  // Under /var/tmp, not /tmp: the sandbox mounts its own private /tmp.
  const base = existsSync('/var/tmp') ? '/var/tmp' : tmpdir()
  const root = realpathSync(mkdtempSync(join(base, 'orbit-confine-')))
  try {
    const home = join(root, 'home')
    const ws = join(home, 'projets', 'a')
    const other = join(home, 'projets', 'b')
    const engineDir = join(home, '.engine')
    for (const d of [join(home, '.ssh'), ws, other, engineDir]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'FAKE-PRIVATE-KEY\n')
    writeFileSync(join(home, 'runtime.db'), 'FAKE-DATABASE\n')
    writeFileSync(join(other, 'secret.txt'), 'AUTRE-PROJET\n')
    writeFileSync(join(ws, 'inside.txt'), 'inside\n')
    writeFileSync(join(engineDir, 'state'), 'engine\n')
    symlinkSync(join(home, 'runtime.db'), join(ws, 'lien.txt'))
    const spec = { workspace: ws, readable: [engineDir], writable: [], workspaceWritable: true, home }
    const run = (cmd: string, args: string[]) => spawnSync(bwrapPath()!, bwrapArgs(spec, cmd, args), { encoding: 'utf8', timeout: 10_000 })
    const probe = run('/bin/cat', [join(ws, 'inside.txt')])
    if (probe.status !== 0 && /namespace|permission|Operation not permitted|setting up uid map/i.test(probe.stderr)) return { ok: false, checkedAt, checks: [], error: `bubblewrap ne peut pas créer d’espace isolé ici : ${probe.stderr.trim().split('\n').pop()}` }
    const checks = [
      { label: 'Lecture dans le projet autorisé', ok: probe.stdout === 'inside\n' },
      { label: 'Lecture de l’état du moteur', ok: run('/bin/cat', [join(engineDir, 'state')]).status === 0 },
      { label: 'Base du runtime invisible', ok: run('/bin/cat', [join(home, 'runtime.db')]).status !== 0 },
      { label: 'Autre projet invisible', ok: run('/bin/cat', [join(other, 'secret.txt')]).status !== 0 },
      { label: 'Clé SSH factice illisible', ok: run('/bin/cat', [join(home, '.ssh', 'id_ed25519')]).status !== 0 },
      { label: 'Lien symbolique vers l’extérieur bloqué', ok: run('/bin/cat', [join(ws, 'lien.txt')]).status !== 0 },
      { label: 'Sous-processus (sh -c) confiné', ok: run('/bin/sh', ['-c', `cat '${join(home, 'runtime.db')}'`]).status !== 0 },
      { label: 'Écriture hors du projet refusée', ok: run('/bin/sh', ['-c', `echo x > '${join(home, 'pirate.txt')}'`]).status !== 0 && !existsSync(join(home, 'pirate.txt')) },
      { label: 'Écriture système refusée', ok: run('/bin/sh', ['-c', 'echo x > /etc/orbit-pirate']).status !== 0 },
      { label: 'Écriture dans le projet autorisée', ok: run('/bin/sh', ['-c', `echo x > '${join(ws, 'ok.txt')}'`]).status === 0 && existsSync(join(ws, 'ok.txt')) },
    ]
    return { ok: checks.every((c) => c.ok), checkedAt, checks, error: null }
  } catch (err) {
    return { ok: false, checkedAt, checks: [], error: err instanceof Error ? err.message : String(err) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
