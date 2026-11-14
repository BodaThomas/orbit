import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Git worktrees give each writer its own checkout on its own branch: two companions never
 * edit the same files at the same time. This separates *workspaces*; it is not a security
 * boundary (processes still run as the user - see docs/SECURITY.md).
 *
 * Nothing here touches the user's checkout except `merge`, which only runs on an explicit
 * click, refuses a dirty working tree, and aborts cleanly on conflict.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return stdout
}

export async function repoRoot(path: string): Promise<string | null> {
  try {
    return (await git(path, ['rev-parse', '--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

export async function headRef(repo: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', 'HEAD'])).trim()
  } catch {
    return null
  }
}

export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  await git(repo, ['worktree', 'add', '-b', branch, path, base])
}

/** Commits whatever the agent left in its worktree, so the branch carries its work. */
export async function commitAll(worktree: string, message: string): Promise<boolean> {
  await git(worktree, ['add', '-A'])
  const status = (await git(worktree, ['status', '--porcelain'])).trim()
  if (!status) return false
  await git(worktree, ['-c', 'user.name=Orbit', '-c', 'user.email=orbit@localhost', 'commit', '-q', '--no-verify', '-m', message])
  return true
}

export async function diffStat(repo: string, base: string, branch: string): Promise<string> {
  return (await git(repo, ['diff', '--stat', `${base}...${branch}`])).trim()
}

export async function branchDiff(repo: string, base: string, branch: string): Promise<string> {
  return (await git(repo, ['diff', '--no-color', `${base}...${branch}`])).slice(0, 200_000)
}

/** Conflict check without touching any checkout (git ≥ 2.38). */
export async function conflictsBetween(repo: string, a: string, b: string): Promise<boolean> {
  try {
    await git(repo, ['merge-tree', '--write-tree', '--no-messages', a, b])
    return false
  } catch (err) {
    // Exit status 1 = conflicts; anything else is a real error.
    if ((err as { code?: number }).code === 1) return true
    throw err
  }
}

export async function isClean(repo: string): Promise<boolean> {
  return !(await git(repo, ['status', '--porcelain', '--untracked-files=no'])).trim()
}

/** User-triggered merge into the current branch of the user's checkout. Never forced. */
export async function mergeBranch(repo: string, branch: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await isClean(repo))) return { ok: false, reason: 'Votre dossier contient des modifications non enregistrées : enregistrez-les (commit) ou mettez-les de côté avant de fusionner.' }
  try {
    await git(repo, ['-c', 'user.name=Orbit', '-c', 'user.email=orbit@localhost', 'merge', '--no-ff', '--no-edit', branch])
    return { ok: true }
  } catch {
    await git(repo, ['merge', '--abort']).catch(() => undefined)
    return { ok: false, reason: 'Conflit de fusion : rien n’a été modifié. Résolvez-le manuellement (git merge) ou écartez l’une des propositions.' }
  }
}

export async function removeWorktree(repo: string, path: string, branch: string | null, deleteBranch: boolean): Promise<void> {
  if (existsSync(path)) await git(repo, ['worktree', 'remove', '--force', path]).catch(() => undefined)
  await git(repo, ['worktree', 'prune']).catch(() => undefined)
  if (branch && deleteBranch) await git(repo, ['branch', '-D', branch]).catch(() => undefined)
}
